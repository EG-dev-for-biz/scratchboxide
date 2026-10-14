/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * ffmpeg image codec: JPEG round trips carry no colour bias (exact JFIF conversion; ffmpeg's own RGB -> yuvj
 * conversion shifted every re-encoded texel by about dRGB (-0.6, +0.5, -0.9)), the synchronous decoder matches
 * the asynchronous one, PNG decodes in-process, and the JFIF conversion pair is the identity up to rounding.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import {
    encodeRgbaToJpeg, decodeImageToRgba, decodeImageToRgbaSync, rgbaToJfifYcc444, jfifYcc444ToRgba, readImageDimensions
} from '../src/node/image-codec-ffmpeg';
import { encodePng } from '../src/node/texture-processing';

/** Deterministic photo-like test image: smooth colour gradients plus fine texture. */
function testImage(w: number, h: number): Buffer {
    const rgba = Buffer.alloc(w * h * 4);
    let seed = 12345;
    const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        const n = (rnd() - 0.5) * 30;
        rgba[i] = Math.max(0, Math.min(255, Math.round(60 + 140 * x / w + n)));
        rgba[i + 1] = Math.max(0, Math.min(255, Math.round(170 - 90 * y / h + n)));
        rgba[i + 2] = Math.max(0, Math.min(255, Math.round(90 + 60 * Math.sin(x / 9) * Math.cos(y / 13) + n)));
        rgba[i + 3] = 255;
    }
    return rgba;
}

const meanDiff = (a: Buffer, b: Buffer): [number, number, number] => {
    const s = [0, 0, 0];
    const n = a.length / 4;
    for (let i = 0; i < n; i++) for (let c = 0; c < 3; c++) s[c] += b[i * 4 + c] - a[i * 4 + c];
    return [s[0] / n, s[1] / n, s[2] / n];
};

describe('image-codec-ffmpeg', () => {
    it('JFIF Y\'CbCr conversion round-trips within rounding', () => {
        const img = testImage(64, 48);
        const back = jfifYcc444ToRgba(rgbaToJfifYcc444(img, 64, 48), 64, 48);
        let worst = 0;
        for (let i = 0; i < img.length; i++) if (i % 4 !== 3) worst = Math.max(worst, Math.abs(back[i] - img[i]));
        expect(worst).toBeLessThanOrEqual(2);
    });

    it('JPEG encode -> decode has no colour bias (4:4:4 and 4:2:0)', async () => {
        const W = 256, H = 192, img = testImage(W, H);
        for (const chroma of ['444', '420'] as const) {
            const jpg = await encodeRgbaToJpeg(img, W, H, { quality: 92, chroma });
            expect(readImageDimensions(jpg)).toEqual({ width: W, height: H });
            const dec = await decodeImageToRgba(jpg);
            const d = meanDiff(img, dec.rgba);
            // ffmpeg's own colour conversion measured (-0.6, +0.5, -0.9) here
            for (const v of d) expect(Math.abs(v)).toBeLessThan(0.25);
        }
    }, 60000);

    it('the synchronous decoder matches the asynchronous one and PNG decodes in-process', async () => {
        const W = 96, H = 64, img = testImage(W, H);
        const jpg = await encodeRgbaToJpeg(img, W, H, { quality: 90 });
        const a = await decodeImageToRgba(jpg), b = decodeImageToRgbaSync(jpg);
        expect(b.width).toBe(W);
        expect(Buffer.compare(a.rgba, b.rgba)).toBe(0);
        const png = encodePng(W, H, img);
        expect(Buffer.compare(decodeImageToRgbaSync(png).rgba, img)).toBe(0);
        expect(Buffer.compare((await decodeImageToRgba(png)).rgba, img)).toBe(0);
        // a screenshot of the round trip for the visual record (gitignored)
        const dir = path.resolve(process.cwd(), 'test-results/screenshots');
        fs.mkdirSync(dir, { recursive: true });
        const both = Buffer.alloc(W * 2 * H * 4);
        for (let y = 0; y < H; y++) { img.copy(both, y * W * 8, y * W * 4, (y + 1) * W * 4); b.rgba.copy(both, y * W * 8 + W * 4, y * W * 4, (y + 1) * W * 4); }
        fs.writeFileSync(path.join(dir, 'image_codec_ffmpeg_jpeg_roundtrip.png'), encodePng(W * 2, H, both));
    }, 60000);

    it('rejects unknown formats', async () => {
        await expect(decodeImageToRgba(Buffer.from('not an image'))).rejects.toThrow(/unrecognised/);
        expect(() => decodeImageToRgbaSync(Buffer.from('not an image'))).toThrow(/unrecognised/);
    });
});
