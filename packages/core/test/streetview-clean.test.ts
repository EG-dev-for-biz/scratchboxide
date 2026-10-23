/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The obstruction-free copy of a Street View photo (streetview-clean.ts) and its use as a model reference only
 * (plate-streetview.ts referenceView). The image model is a local function (it fills the magenta from the row's nearest real
 * pixel), so nothing bills.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanStreetViewImage, CLEAN_MIN_PIXELS } from '../src/node/3d-engine/staged-location/streetview-clean';
import { referenceView, type GuideView } from '../src/node/3d-engine/staged-location/pipeline-e/plate-streetview';
import type { EnhanceModelClient } from '../src/node/3d-engine/staged-location/texture-enhance';
import { decodeImageInMemory, type RgbaImage8 } from '../src/node/3d-engine/staged-location/tile-texture-transfer';
import { encodePng } from '../src/node/texture-processing';

const W = 200, H = 150;
/** A wall (a smooth gradient with a darker window grid) and, standing in front of it, a green "tree" 30 x 50 at (90, 60). */
function photo(): { image: RgbaImage8; occluders: Uint8Array } {
    const rgba = new Uint8Array(W * H * 4), occluders = new Uint8Array(W * H);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const o = (y * W + x) * 4, window = x % 25 < 10 && y % 30 < 14;
        rgba[o] = window ? 60 : 150 + Math.round(x * 0.1); rgba[o + 1] = window ? 65 : 110 + Math.round(y * 0.1); rgba[o + 2] = window ? 80 : 90; rgba[o + 3] = 255;
        if (x >= 90 && x < 120 && y >= 60 && y < 110) { rgba[o] = 40; rgba[o + 1] = 140; rgba[o + 2] = 50; occluders[y * W + x] = 1; }
    }
    return { image: { width: W, height: H, rgba }, occluders };
}

const isMagenta = (p: Uint8Array, o: number) => p[o] > 200 && p[o + 2] > 200 && p[o + 1] < 90;
let calls = 0;
const rowFill: EnhanceModelClient = async req => {
    calls++;
    const img = decodeImageInMemory(req.image.bytes);
    const p = Uint8Array.from(img.rgba);
    for (let y = 0; y < img.height; y++) {
        let last: number[] | undefined;
        for (let x = 0; x < img.width; x++) {
            const o = (y * img.width + x) * 4;
            if (isMagenta(p, o)) { if (last) p.set(last, o); } else last = [p[o], p[o + 1], p[o + 2]];
        }
    }
    return { bytes: new Uint8Array(encodePng(img.width, img.height, Buffer.from(p))), mimeType: 'image/png', modelUsed: 'local-row-fill', requestedModels: ['local-row-fill'], skippedModels: [], modelNote: 'local' };
};
const broken: EnhanceModelClient = async () => { throw new Error('the image model is unavailable'); };
const lazy: EnhanceModelClient = async req => ({ bytes: req.image.bytes, mimeType: 'image/png', modelUsed: 'local-lazy', requestedModels: ['local-lazy'], skippedModels: [], modelNote: 'local' });

afterEach(() => { delete process.env.SCRATCHBOX_STREETVIEW_CLEAN; calls = 0; });

describe('obstruction-free Street View copy', () => {
    it('fills only the occluder pixels, keeps every other pixel bit-identical, and labels the fill generated', async () => {
        const { image, occluders } = photo();
        const r = await cleanStreetViewImage({ image, occluders, client: rowFill, models: ['local-row-fill'] });
        expect(r.decision).toBe('accepted');
        expect(r.provenance.label).toBe('generated');
        expect(r.filledPixels).toBeGreaterThanOrEqual(30 * 50);
        let changedOutside = 0, greenLeft = 0, filledOutsideGrown = 0;
        for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
            const i = y * W + x, o = i * 4;
            const near = x >= 88 && x < 122 && y >= 58 && y < 112; // the occluder grown by the fill's 2 px
            if (!r.filledMask[i]) { for (let c = 0; c < 4; c++) if (r.image.rgba[o + c] !== image.rgba[o + c]) changedOutside++; }
            else if (!near) filledOutsideGrown++;
            if (occluders[i] && r.image.rgba[o + 1] > 130 && r.image.rgba[o] < 60) greenLeft++;
        }
        expect(changedOutside).toBe(0);
        expect(filledOutsideGrown).toBe(0);
        expect(greenLeft).toBe(0);
        // the input is not modified
        expect(image.rgba[(70 * W + 100) * 4 + 1]).toBe(140);
    });

    it('a failed or rejected fill leaves the photo as captured, with the reason', async () => {
        const { image, occluders } = photo();
        const failed = await cleanStreetViewImage({ image, occluders, client: broken, models: ['x'] });
        expect(failed.decision).toBe('model_failed');
        expect(failed.image).toBe(image);
        expect(failed.filledPixels).toBe(0);
        expect(failed.provenance.label).toBe('as-captured');
        expect(failed.reason).toBeTruthy();
        const rejected = await cleanStreetViewImage({ image, occluders, client: lazy, models: ['x'] });
        expect(rejected.decision).toBe('rejected');
        expect(rejected.image).toBe(image);
        expect(rejected.reason).toBeTruthy();
    });

    it('skips too few occluder pixels and the kill switch, without a model call', async () => {
        const { image } = photo();
        const few = new Uint8Array(W * H); few.fill(1, 0, CLEAN_MIN_PIXELS - 1);
        expect((await cleanStreetViewImage({ image, occluders: few, client: rowFill, models: ['x'] })).decision).toBe('too_few_occluders');
        process.env.SCRATCHBOX_STREETVIEW_CLEAN = '0';
        expect((await cleanStreetViewImage({ image, occluders: photo().occluders, client: rowFill, models: ['x'] })).decision).toBe('disabled');
        expect(calls).toBe(0);
    });

    it('keeps an accepted fill in the cache and serves it again without a model call', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sv-clean-'));
        const { image, occluders } = photo();
        const a = await cleanStreetViewImage({ image, occluders, client: rowFill, models: ['x'], cacheDir: dir });
        expect(calls).toBe(1);
        const b = await cleanStreetViewImage({ image, occluders, client: rowFill, models: ['x'], cacheDir: dir });
        expect(calls).toBe(1);
        expect(b.cached).toBe(true);
        expect(Buffer.from(b.image.rgba).equals(Buffer.from(a.image.rgba))).toBe(true);
        expect(Buffer.from(b.filledMask).equals(Buffer.from(a.filledMask))).toBe(true);
    });

    it('the reference view takes the clean copy and its filled pixels; the view itself stays the photo as captured', async () => {
        const { image, occluders } = photo();
        const r = await cleanStreetViewImage({ image, occluders, client: rowFill, models: ['x'] });
        const owner = new Uint8Array(W * H).fill(1); for (let i = 0; i < W * H; i++) if (occluders[i]) owner[i] = 0;
        const depth = new Float32Array(W * H).fill(10);
        const v = { panoId: 'p', image, ownerMask: owner, depth, cleanImage: r.image, cleanFilledMask: r.filledMask } as unknown as GuideView;
        const ref = referenceView(v);
        expect(ref.image).toBe(r.image);
        expect(ref.ownerMask![100 * W + 100]).toBe(1);
        expect(Number.isNaN(ref.depth![100 * W + 100])).toBe(true);
        // the original view is untouched (checks against the photo read it)
        expect(v.image).toBe(image);
        expect(v.ownerMask![100 * W + 100]).toBe(0);
        expect(v.depth![100 * W + 100]).toBe(10);
        // a view with no clean copy is its own reference
        const plain = { panoId: 'q', image, ownerMask: owner } as unknown as GuideView;
        expect(referenceView(plain)).toBe(plain);
    });
});
