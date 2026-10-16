/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/** Colours measured from pixels: a synthetic image with known colours, decoded in memory only. */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as jpegJs from 'jpeg-js';
import { measurePalette, paletteOfJpeg, decodeJpegInMemory } from '../src/node/3d-engine/staged-location/photo-palette';
import { ProColorGradeMatchingService as Colour } from '../src/node/image/ProColorGradeMatchingService';

const STONE: [number, number, number] = [201, 182, 152];
const GREY: [number, number, number] = [118, 120, 126];
const DARK: [number, number, number] = [38, 44, 52];

/** 120 x 100: left 50% stone, middle 30% grey, right 20% dark, with a deterministic +-3 texture. */
function stripes(): { width: number; height: number; data: Buffer } {
    const width = 120, height = 100;
    const data = Buffer.alloc(width * height * 4);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
        const c = x < 60 ? STONE : x < 96 ? GREY : DARK;
        const jitter = ((x * 7 + y * 13) % 7) - 3;
        const i = (y * width + x) * 4;
        data[i] = c[0] + jitter; data[i + 1] = c[1] + jitter; data[i + 2] = c[2] + jitter; data[i + 3] = 255;
    }
    return { width, height, data };
}
const deltaE = (a: number[], b: number[]) => Colour.calculateDeltaE00(Colour.srgbToLab(a[0], a[1], a[2]), Colour.srgbToLab(b[0], b[1], b[2]));

describe('measured palette', () => {
    it('recovers the known colours of a synthetic image, with their shares, through a real JPEG decode in memory', () => {
        const img = stripes();
        const jpeg = jpegJs.encode(img, 95).data;
        const listing = () => new Set([...fs.readdirSync(os.tmpdir()), ...fs.readdirSync(process.cwd())]);
        const before = listing();
        const p = paletteOfJpeg(jpeg);
        // nothing new on disk (no temp file, no image), nothing spawned (no ffmpeg): the decode and the measurement are in memory
        expect([...listing()].filter(f => !before.has(f))).toEqual([]);
        expect(p.measuredFromPhoto).toBe(true);
        expect(p.colours.length).toBe(3);
        const near = (truth: number[]) => p.colours.find(c => deltaE(c.srgb, truth) < 3.5);
        const stone = near(STONE), grey = near(GREY), dark = near(DARK);
        expect(stone && grey && dark).toBeTruthy();
        expect(stone!.share).toBeCloseTo(0.5, 1); expect(grey!.share).toBeCloseTo(0.3, 1); expect(dark!.share).toBeCloseTo(0.2, 1);
        // largest first, values are sRGB integers and the hex is theirs
        expect(p.colours.map(c => c.share)).toEqual([...p.colours.map(c => c.share)].sort((a, b) => b - a));
        for (const c of p.colours) expect(c.hex).toBe('#' + c.srgb.map(v => v.toString(16).padStart(2, '0')).join(''));
    });

    it('merges two nearly identical colours into one (CIEDE2000), keeps two distinct ones apart', () => {
        const w = 40, h = 40, data = Buffer.alloc(w * h * 4);
        for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
            const i = (y * w + x) * 4;
            const c = x < 10 ? [200, 180, 150] : x < 20 ? [203, 183, 153] : x < 30 ? [60, 90, 140] : [200, 180, 150];
            data[i] = c[0]; data[i + 1] = c[1]; data[i + 2] = c[2]; data[i + 3] = 255;
        }
        const p = measurePalette({ width: w, height: h, data });
        expect(p.colours.length).toBe(2);
        expect(p.colours[0].share).toBeCloseTo(0.75, 1);
        expect(deltaE(p.colours[1].srgb, [60, 90, 140])).toBeLessThan(1);
    });

    it('measures only inside the given regions, and is deterministic', () => {
        const img = stripes();
        // the left half of the frame only: stone
        const onlyStone = measurePalette(img, { regions1000: [[0, 0, 1000, 480]] });
        expect(onlyStone.colours.length).toBe(1);
        expect(deltaE(onlyStone.colours[0].srgb, STONE)).toBeLessThan(2);
        const a = measurePalette(img), b = measurePalette(img);
        expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    });

    it('refuses bytes that are not a JPEG instead of guessing', () => {
        expect(() => decodeJpegInMemory(Buffer.from('not an image'))).toThrow();
    });
});
