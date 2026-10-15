/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * pbr_material_decompose on a real encoded image: the JPEG is decoded at its real size, the albedo, normal and
 * ORM PNGs are computed from its pixels (not a flat buffer), normals follow glTF (+Y toward the image top), and a
 * missing or undecodable image fails the call without writing maps. A contact sheet of the input and the three
 * maps is written to test-results/screenshots/.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { algorithmicUvHandlers } from '../src/node/gemini/tools/algorithmic-uv-tools';
import { decodeImageToRgba, encodeRgbaToJpeg } from '../src/node/image-codec-ffmpeg';
import { decodePng, encodePng } from '../src/node/texture-processing';
import { REPO_ROOT } from './helpers/requirements';

const SCREENSHOT_DIR = path.join(REPO_ROOT, 'test-results', 'screenshots');
const decompose = algorithmicUvHandlers.pbr_material_decompose;

/** Deterministic stone-like texture: courses of blocks with mortar joints, a cast shadow band and grain. */
function stoneTexture(w: number, h: number): Buffer {
    const rgba = Buffer.alloc(w * h * 4);
    let seed = 987654321;
    const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            const course = Math.floor(y / 16);
            const joint = y % 16 < 2 || (x + (course % 2) * 12) % 24 < 2;
            const shadow = x > w * 0.55 ? 0.45 : 1.0;
            const grain = (rnd() - 0.5) * 24;
            const base = joint ? 70 : 185;
            const i = (y * w + x) * 4;
            rgba[i] = Math.max(0, Math.min(255, Math.round((base + 8) * shadow + grain)));
            rgba[i + 1] = Math.max(0, Math.min(255, Math.round(base * shadow + grain)));
            rgba[i + 2] = Math.max(0, Math.min(255, Math.round((base - 14) * shadow + grain)));
            rgba[i + 3] = 255;
        }
    }
    return rgba;
}

/** Distinct values of one channel; a flat map has exactly one. */
function distinctValues(rgba: Buffer, channel: number): number {
    const seen = new Set<number>();
    for (let i = channel; i < rgba.length; i += 4) seen.add(rgba[i]);
    return seen.size;
}

const meanAbsDiff = (a: Buffer, b: Buffer): number => {
    let s = 0, n = 0;
    for (let i = 0; i < a.length; i++) if (i % 4 !== 3) { s += Math.abs(a[i] - b[i]); n++; }
    return s / n;
};

/** Places equally sized RGBA images side by side. */
function contactSheet(images: Buffer[], w: number, h: number): Buffer {
    const out = Buffer.alloc(images.length * w * h * 4);
    images.forEach((img, k) => {
        for (let y = 0; y < h; y++) img.copy(out, (y * images.length * w + k * w) * 4, y * w * 4, (y + 1) * w * 4);
    });
    return encodePng(images.length * w, h, out);
}

describe('pbr_material_decompose on a real image', () => {
    let dir: string;
    beforeAll(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pbr-decompose-')); });
    afterAll(() => { fs.rmSync(dir, { recursive: true, force: true }); });

    it('decodes the JPEG at its real size and writes albedo, normal and ORM PNGs computed from its pixels', async () => {
        const W = 96, H = 64;
        const jpeg = await encodeRgbaToJpeg(stoneTexture(W, H), W, H, { quality: 90 });
        const inputImagePath = path.join(dir, 'wall.jpg');
        fs.writeFileSync(inputImagePath, jpeg);
        const outputDir = path.join(dir, 'maps');

        const out = await decompose({ inputImagePath, outputDir }, {} as any);
        const payload = out.resultPayload as any;

        expect(out.status).toBe('completed');
        expect(payload).toMatchObject({
            success: true, format: 'jpeg', width: W, height: H, albedoDeLit: true,
            albedoPath: path.join(outputDir, 'wall_albedo.png'),
            normalPath: path.join(outputDir, 'wall_normal.png'),
            ormPath: path.join(outputDir, 'wall_orm.png')
        });
        expect(out.summaryResult).toContain(`${W}x${H} JPEG`);
        expect(out.summaryResult).not.toMatch(/RNM|Toksvig|HBAO|Sky-Dome/);

        const input = await decodeImageToRgba(jpeg);
        const [albedo, normal, orm] = [payload.albedoPath, payload.normalPath, payload.ormPath].map((p: string) => decodePng(fs.readFileSync(p)));
        for (const img of [albedo, normal, orm]) expect([img.width, img.height]).toEqual([W, H]);

        // Albedo: the de-lit image, not the input and not flat.
        expect(meanAbsDiff(albedo.rgba, input.rgba)).toBeGreaterThan(5);
        expect(distinctValues(albedo.rgba, 0)).toBeGreaterThan(20);

        // Normal map: unit-length, facing out, and tilted wherever the texture has edges.
        expect(distinctValues(normal.rgba, 0)).toBeGreaterThan(10);
        expect(distinctValues(normal.rgba, 1)).toBeGreaterThan(10);
        let tilted = 0;
        for (let i = 0; i < W * H; i++) {
            const nx = normal.rgba[i * 4] / 127.5 - 1, ny = normal.rgba[i * 4 + 1] / 127.5 - 1, nz = normal.rgba[i * 4 + 2] / 127.5 - 1;
            expect(nz).toBeGreaterThan(0);
            expect(Math.abs(Math.hypot(nx, ny, nz) - 1)).toBeLessThan(0.03);
            if (Math.abs(nx) > 0.05 || Math.abs(ny) > 0.05) tilted++;
        }
        expect(tilted / (W * H)).toBeGreaterThan(0.2);

        // ORM: R = AO and G = roughness vary across the image; B = metalness is the contract's constant 0.
        expect(distinctValues(orm.rgba, 0)).toBeGreaterThan(5);
        expect(distinctValues(orm.rgba, 1)).toBeGreaterThan(10);
        for (let i = 0; i < W * H; i++) expect(orm.rgba[i * 4 + 2]).toBe(0);

        fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
        fs.writeFileSync(path.join(SCREENSHOT_DIR, 'pbr_material_decompose_real_image_maps.png'),
            contactSheet([input.rgba, albedo.rgba, normal.rgba, orm.rgba], W, H));
    });

    it('writes glTF (+Y toward the image top) normals and the decoded pixels as albedo when de-lighting is off', async () => {
        // Luminance rising toward the top of the image: the surface faces the bottom, -Y in glTF tangent space.
        const W = 48, H = 32;
        const ramp = Buffer.alloc(W * H * 4);
        for (let y = 0; y < H; y++) {
            for (let x = 0; x < W; x++) {
                const v = Math.round(40 + 180 * (1 - y / (H - 1)));
                ramp.set([v, v, v, 255], (y * W + x) * 4);
            }
        }
        const inputImagePath = path.join(dir, 'ramp.png');
        fs.writeFileSync(inputImagePath, encodePng(W, H, ramp));

        const out = await decompose({ inputImagePath, enableAlbedoDeLighting: false }, {} as any);
        const payload = out.resultPayload as any;
        expect(out.status).toBe('completed');
        expect(payload).toMatchObject({ format: 'png', width: W, height: H, albedoDeLit: false });
        // Default output directory is the input image's directory.
        expect(payload.normalPath).toBe(path.join(dir, 'ramp_normal.png'));

        expect(decodePng(fs.readFileSync(payload.albedoPath)).rgba.equals(ramp)).toBe(true);
        const normal = decodePng(fs.readFileSync(payload.normalPath));
        let sumR = 0, sumG = 0, n = 0;
        for (let y = 4; y < H - 4; y++) {
            for (let x = 4; x < W - 4; x++) { sumR += normal.rgba[(y * W + x) * 4]; sumG += normal.rgba[(y * W + x) * 4 + 1]; n++; }
        }
        expect(sumG / n).toBeLessThan(120);
        expect(Math.abs(sumR / n - 127.5)).toBeLessThan(2);
    });

    it('fails without writing maps when the image is missing, unreadable or undecodable', async () => {
        const outputDir = path.join(dir, 'no-maps');

        const noPath = await decompose({ outputDir }, {} as any);
        expect(noPath.status).toBe('failed');
        expect((noPath.resultPayload as any).success).toBe(false);
        expect(noPath.summaryResult).toMatch(/inputImagePath is required/);

        const missing = await decompose({ inputImagePath: path.join(dir, 'does-not-exist.jpg'), outputDir }, {} as any);
        expect(missing.status).toBe('failed');
        expect(missing.summaryResult).toMatch(/could not read/);

        const corruptPath = path.join(dir, 'corrupt.jpg');
        fs.writeFileSync(corruptPath, Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(200, 0x5a)]));
        const corrupt = await decompose({ inputImagePath: corruptPath, outputDir }, {} as any);
        expect(corrupt.status).toBe('failed');
        expect(corrupt.summaryResult).toMatch(/could not decode/);

        const textPath = path.join(dir, 'notes.jpg');
        fs.writeFileSync(textPath, 'not an image');
        const text = await decompose({ inputImagePath: textPath, outputDir }, {} as any);
        expect(text.status).toBe('failed');
        expect(text.summaryResult).toMatch(/not a JPEG, PNG or WebP image/);

        // 16-bit PNG: decodePng would mis-read it, so it is rejected before decoding.
        const png16 = encodePng(4, 4, Buffer.alloc(64, 128));
        png16[24] = 16;
        const png16Path = path.join(dir, 'deep.png');
        fs.writeFileSync(png16Path, png16);
        const deep = await decompose({ inputImagePath: png16Path, outputDir }, {} as any);
        expect(deep.status).toBe('failed');
        expect(deep.summaryResult).toMatch(/unsupported PNG variant \(bit depth 16/);

        expect(fs.existsSync(outputDir)).toBe(false);
    });
});
