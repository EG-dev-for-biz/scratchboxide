/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The PNG codec pool (png-codec-pool.ts) against the synchronous codec it runs on worker threads: the same PNG bytes for
 * every channel count and size, the same decoded pixels, the caller's arrays left usable, errors carried back, and the
 * event loop kept free while large images are coded (the reason it exists: pipeline K's straightening step blocked the
 * server for 15 s decoding, refilling and re-encoding facade orthos, docs/processes/pipeline_k_native_kernels_timing_esb.md).
 */

import { afterAll, describe, expect, it } from 'vitest';
import { encodePng } from '../src/node/3d-engine/staged-location/png-encode';
import { decodePng } from '../src/node/texture-processing';
import { closePngCodecPool, decodePngAsync, delightImageAsync, encodePngAsync, INLINE_MAX_BYTES } from '../src/node/png-codec-pool';
import { delightImage } from '../src/node/3d-engine/staged-location/pipeline-k/twin-delight';
import { TEXEL_ROOF } from '../src/node/3d-engine/staged-location/pipeline-k/texture-harmonize';

/** A facade-like image: storey bands and window columns, a smooth light gradient and seeded noise. */
function facade(width: number, height: number, channels: 1 | 3 | 4, seed = 7): Uint8Array {
    const px = new Uint8Array(width * height * channels);
    let s = seed >>> 0;
    const rnd = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
        const window = x % 24 > 6 && x % 24 < 18 && y % 40 > 10 && y % 40 < 32;
        const base = window ? 50 : 170 - (y / height) * 60;
        for (let c = 0; c < channels; c++) {
            const v = c === 3 ? (x < 3 ? 0 : 255) : base + (c - 1) * 12 + rnd() * 18;
            px[(y * width + x) * channels + c] = Math.max(0, Math.min(255, Math.round(v)));
        }
    }
    return px;
}

/** The longest the event loop went without a 10 ms tick while `work` ran. */
async function maxLagDuring(work: () => Promise<unknown>): Promise<number> {
    let max = 0, last = performance.now();
    const timer = setInterval(() => { const n = performance.now(); max = Math.max(max, n - last - 10); last = n; }, 10);
    await work();
    // one more tick, so a stall that ends with the work is counted
    await new Promise(r => setTimeout(r, 15));
    clearInterval(timer);
    return Math.max(max, performance.now() - last - 10);
}

afterAll(() => closePngCodecPool());

describe('PNG codec pool', () => {
    it('encodes the same PNG bytes as encodePng for grey, RGB and RGBA at every size', async () => {
        for (const [w, h] of [[1, 1], [17, 9], [256, 256], [640, 1800]] as const) {
            for (const ch of [1, 3, 4] as const) {
                const px = facade(w, h, ch, w * 31 + ch);
                const sync = encodePng(w, h, px, ch);
                const pooled = await encodePngAsync(w, h, px, ch);
                expect(pooled.equals(sync), `${w}x${h}x${ch}`).toBe(true);
            }
        }
    });

    it('decodes the same pixels as decodePng, for PNGs of each colour type', async () => {
        for (const ch of [1, 3, 4] as const) {
            const png = encodePng(900, 1400, facade(900, 1400, ch, ch), ch);
            expect(png.byteLength).toBeGreaterThan(INLINE_MAX_BYTES);
            const sync = decodePng(png), pooled = await decodePngAsync(png);
            expect([pooled.width, pooled.height]).toEqual([sync.width, sync.height]);
            expect(pooled.rgba.equals(sync.rgba)).toBe(true);
            expect(pooled.data).toBe(pooled.rgba);
        }
    });

    it('leaves the caller\'s pixels and PNG usable, and codes many at once in any order', async () => {
        const px = facade(800, 1200, 4, 3);
        const before = Buffer.from(px);
        const pngs = await Promise.all(Array.from({ length: 12 }, () => encodePngAsync(800, 1200, px, 4)));
        expect(Buffer.from(px).equals(before)).toBe(true);
        const sync = encodePng(800, 1200, px, 4);
        for (const p of pngs) expect(p.equals(sync)).toBe(true);
        const decoded = await Promise.all(pngs.map(p => decodePngAsync(p)));
        for (const d of decoded) expect(d.rgba.equals(decodePng(sync).rgba)).toBe(true);
        expect(pngs[0].byteLength).toBe(sync.byteLength);
    });

    it('carries the codec\'s errors back', async () => {
        const junk = Buffer.alloc(INLINE_MAX_BYTES * 2, 7);
        await expect(decodePngAsync(junk)).rejects.toThrow('Invalid PNG signature');
        await expect(encodePngAsync(800, 1200, new Uint8Array(800 * 1200 * 4 - 1), 4)).rejects.toThrow('PNG data has');
    });

    it('keeps the event loop free while large facade orthos are encoded and decoded', async () => {
        const images = Array.from({ length: 8 }, (_, i) => facade(1200, 2400, 4, 100 + i));
        // warm the pool so a thread's start-up is not counted against it
        await encodePngAsync(1200, 2400, images[0], 4);
        let t = performance.now();
        const syncLag = await maxLagDuring(async () => { for (const px of images) decodePng(encodePng(1200, 2400, px, 4)); });
        const syncMs = performance.now() - t;
        t = performance.now();
        const poolLag = await maxLagDuring(() => Promise.all(images.map(async px => decodePngAsync(await encodePngAsync(1200, 2400, px, 4)))));
        const poolMs = performance.now() - t;
        console.log(`[png-codec-pool] 8 x 1200x2400 RGBA encode+decode: sync ${syncMs.toFixed(0)} ms, longest event-loop stall ${syncLag.toFixed(0)} ms; pool ${poolMs.toFixed(0)} ms, longest stall ${poolLag.toFixed(0)} ms`);
        expect(syncLag).toBeGreaterThan(500);
        expect(poolLag).toBeLessThan(syncLag / 5);
    });
    it('de-lights a photo on a codec thread to the same pixels as on this one, with the roof and upward masks', async () => {
        const width = 300, height = 200, n = width * height;
        let seed = 7;
        const rnd = () => (seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32;
        const rgba = new Uint8Array(n * 4);
        for (let k = 0; k < rgba.length; k++) rgba[k] = Math.floor(rnd() * 256);
        const surface = new Uint8Array(n), up = new Uint8Array(n);
        for (let k = 0; k < n; k++) { if (rnd() < 0.3) surface[k] = TEXEL_ROOF; if (rnd() < 0.2) up[k] = TEXEL_ROOF; }
        expect(rgba.byteLength).toBeGreaterThan(INLINE_MAX_BYTES);
        const img = { width, height, rgba };
        for (const args of [[undefined, undefined], [surface, undefined], [surface, { mask: up, shadowLift: 0.2 }]] as const) {
            const here = delightImage(img, args[0], args[1] as never);
            const there = await delightImageAsync(img, args[0], args[1] as never);
            expect(there.width).toBe(width);
            expect(Buffer.from(there.rgba).equals(Buffer.from(here.rgba))).toBe(true);
        }
        // the caller's photo is untouched
        expect(img.rgba).toBe(rgba);
    });
});
