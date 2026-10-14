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

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import {
    encodeRgbaToJpeg, encodeRgbaToPng, decodeImageToRgba, decodeImageToRgbaSync, rgbaToJfifYcc444, jfifYcc444ToRgba,
    readImageDimensions, resolveFfmpegPath
} from '../src/node/image-codec-ffmpeg';
import { encodePng } from '../src/node/texture-processing';
import { findBinary, HOW_TO, withReason, type Requirement } from './helpers/requirements';

/** The codec spawns resolveFfmpegPath() (FFMPEG_PATH, else `ffmpeg` on PATH), so require exactly that. */
const ffmpeg: Requirement = findBinary(resolveFfmpegPath()) !== null
    ? { ok: true, reason: '' }
    : { ok: false, reason: `\`${resolveFfmpegPath()}\` not found (set FFMPEG_PATH or ${HOW_TO.ffmpeg})` };

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

    it.skipIf(!ffmpeg.ok)(withReason('JPEG encode -> decode has no colour bias (4:4:4 and 4:2:0)', ffmpeg), async () => {
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

    it.skipIf(!ffmpeg.ok)(withReason('the synchronous decoder matches the asynchronous one and PNG decodes in-process', ffmpeg), async () => {
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

    // Same PNG checks as above, kept runnable without ffmpeg (PNG never spawns it).
    it('PNG decodes in-process (sync and async) without ffmpeg', async () => {
        const W = 96, H = 64, img = testImage(W, H);
        const png = encodePng(W, H, img);
        expect(Buffer.compare(decodeImageToRgbaSync(png).rgba, img)).toBe(0);
        expect(Buffer.compare((await decodeImageToRgba(png)).rgba, img)).toBe(0);
    });

    it('rejects unknown formats', async () => {
        await expect(decodeImageToRgba(Buffer.from('not an image'))).rejects.toThrow(/unrecognised/);
        expect(() => decodeImageToRgbaSync(Buffer.from('not an image'))).toThrow(/unrecognised/);
    });
});

/** Without ffmpeg (FFMPEG_PATH pointed at a missing binary) JPEG and PNG go through the in-process codecs. */
describe('image-codec-ffmpeg without ffmpeg (in-process fallback)', () => {
    const REPO = path.resolve(__dirname, '../../..');
    const FACADE_JPG = path.join(REPO, 'desktop-app/public/test_esb_facade.jpg'); // real 4:2:0 baseline photo
    let saved: string | undefined;
    beforeAll(() => { saved = process.env.FFMPEG_PATH; process.env.FFMPEG_PATH = '/nonexistent/ffmpeg-for-test'; });
    afterAll(() => { if (saved === undefined) delete process.env.FFMPEG_PATH; else process.env.FFMPEG_PATH = saved; });

    it('encodes a JPEG and decodes it back (sync and async agree) with no colour bias', async () => {
        const W = 256, H = 192, img = testImage(W, H);
        const jpg = await encodeRgbaToJpeg(img, W, H, { quality: 92 });
        expect(readImageDimensions(jpg)).toEqual({ width: W, height: H });
        const a = await decodeImageToRgba(jpg), b = decodeImageToRgbaSync(jpg);
        expect([a.width, a.height, a.rgba.length]).toEqual([W, H, W * H * 4]);
        expect(Buffer.compare(a.rgba, b.rgba)).toBe(0);
        for (const v of meanDiff(img, a.rgba)) expect(Math.abs(v)).toBeLessThan(0.75);
        let abs = 0;
        for (let i = 0; i < img.length; i++) if (i % 4 !== 3) abs += Math.abs(a.rgba[i] - img[i]);
        expect(abs / (W * H * 3)).toBeLessThan(4); // q92 on a noisy image: a few levels per channel
    });

    it('decodes a real 4:2:0 photo to its header size (sync and async agree)', async () => {
        const jpg = fs.readFileSync(FACADE_JPG);
        const dims = readImageDimensions(jpg)!;
        const dec = await decodeImageToRgba(jpg);
        expect({ width: dec.width, height: dec.height }).toEqual(dims);
        expect(dec.rgba.length).toBe(dims.width * dims.height * 4);
        expect(Buffer.compare(dec.rgba, decodeImageToRgbaSync(jpg).rgba)).toBe(0);
        // the photo is not blank: real tonal range in every channel
        for (let c = 0; c < 3; c++) {
            let lo = 255, hi = 0;
            for (let i = c; i < dec.rgba.length; i += 4) { lo = Math.min(lo, dec.rgba[i]); hi = Math.max(hi, dec.rgba[i]); }
            expect(hi - lo).toBeGreaterThan(100);
        }
    });

    it.skipIf(process.platform !== 'darwin' || !fs.existsSync('/usr/bin/sips'))('matches Apple ImageIO (sips) on the 4:2:0 photo', async () => {
        const jpg = fs.readFileSync(FACADE_JPG);
        const ours = await decodeImageToRgba(jpg);
        const tmp = fs.mkdtempSync(path.join(require('os').tmpdir(), 'codec-sips-'));
        try {
            fs.writeFileSync(path.join(tmp, 'in.jpg'), jpg);
            require('child_process').execFileSync('/usr/bin/sips', ['-s', 'format', 'png', path.join(tmp, 'in.jpg'), '--out', path.join(tmp, 'ref.png')], { stdio: 'pipe' });
            const ref = decodeImageToRgbaSync(fs.readFileSync(path.join(tmp, 'ref.png')));
            expect([ref.width, ref.height]).toEqual([ours.width, ours.height]);
            const d = meanDiff(ref.rgba, ours.rgba);
            let abs = 0;
            for (let i = 0; i < ref.rgba.length; i++) if (i % 4 !== 3) abs += Math.abs(ours.rgba[i] - ref.rgba[i]);
            // jpeg-js replicates subsampled chroma where ImageIO interpolates: small per-texel differences, no bias
            for (const v of d) expect(Math.abs(v)).toBeLessThan(1);
            expect(abs / (ref.width * ref.height * 3)).toBeLessThan(3);
            // side-by-side (ImageIO | jpeg-js) for the visual record (gitignored)
            const W = ref.width, H = ref.height, both = Buffer.alloc(W * 2 * H * 4);
            for (let y = 0; y < H; y++) { ref.rgba.copy(both, y * W * 8, y * W * 4, (y + 1) * W * 4); ours.rgba.copy(both, y * W * 8 + W * 4, y * W * 4, (y + 1) * W * 4); }
            const dir = path.resolve(process.cwd(), 'test-results/screenshots');
            fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(path.join(dir, 'image_codec_jpegjs_vs_imageio.png'), encodePng(W * 2, H, both));
        } finally {
            fs.rmSync(tmp, { recursive: true, force: true });
        }
    });

    it('encodes PNG in-process losslessly', async () => {
        const W = 96, H = 64, img = testImage(W, H);
        const png = await encodeRgbaToPng(img, W, H);
        expect(Buffer.compare((await decodeImageToRgba(png)).rgba, img)).toBe(0);
    });

    it('a corrupt JPEG fails loudly, naming both decoders', async () => {
        const bad = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 7)]);
        await expect(decodeImageToRgba(bad)).rejects.toThrow(/dimensions|jpeg-js/);
        const header = fs.readFileSync(FACADE_JPG).subarray(0, 2000); // valid header, truncated scan
        await expect(decodeImageToRgba(header)).rejects.toThrow(/ffmpeg.*jpeg-js/);
        // (the synchronous decoder's last resort on macOS, sips, accepts truncated JPEGs, so it is not asserted here)
    });
});
