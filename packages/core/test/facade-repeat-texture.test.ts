/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * A facade's photo redrawn from its own repeats: noise and a reflection are voted out, a blurred window edge comes back as a
 * step, a hole the photo never covered is filled from the repeats, and the walls between the repeats stay as photographed.
 */

import { describe, expect, it } from 'vitest';
import { repeatTexture, REPEAT_TEXTURE } from '../src/node/3d-engine/staged-location/facade-repeat-texture';

// 0.1 m texels; four strips of three windows (12 x 16 texels), 30 texels apart, storeys 30 texels apart
const W = 120, H = 100, PX = 0.1;
const windows: Array<[number, number, number, number]> = [];
for (const x0 of [9, 39, 69, 99]) for (const y0 of [10, 40, 70]) windows.push([x0, y0, x0 + 12, y0 + 16]);
const strips: Array<[number, number, number, number]> = [9, 39, 69, 99].map(x0 => [x0, 10, x0 + 12, 86]);
const inWindow = (x: number, y: number) => windows.findIndex(w => x >= w[0] && x < w[2] && y >= w[1] && y < w[3]);

function photo(): Uint8Array {
    const rgba = new Uint8Array(W * H * 4);
    let seed = 7;
    const noise = () => ((seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5) * 60;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const wi = inWindow(x, y);
        // the window: dark glass with a lighter mullion down its middle; the wall light stone
        let v = wi >= 0 ? (x - windows[wi][0] === 6 ? 120 : 40) : 200;
        // blur: the window's first and last columns half way to the wall
        if (wi >= 0 && (x === windows[wi][0] || x === windows[wi][2] - 1)) v = 120;
        const i = (y * W + x) * 4;
        rgba.set([v + noise(), v + noise(), v + noise(), 255].map(c => Math.max(0, Math.min(255, Math.round(c)))), i);
    }
    // a reflection: one window bright sky blue
    const [x0, y0, x1, y1] = windows[4];
    for (let y = y0 + 1; y < y1 - 1; y++) for (let x = x0 + 2; x < x1 - 2; x++) rgba.set([150, 200, 240, 255], (y * W + x) * 4);
    return rgba;
}

const px = (img: Uint8Array, x: number, y: number) => Array.from(img.slice((y * W + x) * 4, (y * W + x) * 4 + 3));
const lum = (c: number[]) => (c[0] + c[1] + c[2]) / 3;

describe("a facade's photo redrawn from its repeats", () => {
    it('votes out noise and a reflection, snaps the blurred edge, keeps the walls and labels what it drew', () => {
        const src = photo();
        const { rgba, report } = repeatTexture({ rgba: src, width: W, height: H }, PX, windows, strips);
        expect(report.label).toBe('generated');
        expect(report.windows).toBe(12);
        // the spandrels between the windows of each strip (two per strip)
        expect(report.spandrels).toBe(8);
        // the reflecting window now reads as glass like the others
        const [rx, ry] = [windows[4][0] + 3, windows[4][1] + 8];
        expect(lum(px(rgba, rx, ry))).toBeLessThan(90);
        expect(lum(px(src, rx, ry))).toBeGreaterThan(180);
        // repeats agree: the same template texel across the windows varies far less than in the photo
        const spread = (img: Uint8Array) => { const v = windows.filter((_, i) => i !== 4).map(w => lum(px(img, w[0] + 3, w[1] + 8))); const m = v.reduce((a, b) => a + b, 0) / v.length; return Math.sqrt(v.reduce((a, b) => a + (b - m) ** 2, 0) / v.length); };
        expect(spread(rgba)).toBeLessThan(spread(src) / 2);
        // the mullion survives the vote
        expect(lum(px(rgba, windows[0][0] + 6, windows[0][1] + 8))).toBeGreaterThan(lum(px(rgba, windows[0][0] + 3, windows[0][1] + 8)) + 40);
        // the blurred first column (half way, 120) is snapped to the glass inside it
        expect(lum(px(rgba, windows[0][0], windows[0][1] + 8))).toBeLessThan(80);
        // the wall between strips is untouched
        expect(px(rgba, 30, 50)).toEqual(px(src, 30, 50));
    });

    it("fills a window the photo never reached from its repeats, and leaves a group too small to vote as it is", () => {
        const src = photo();
        const uncovered = new Uint8Array(W * H);
        const [x0, y0, x1, y1] = windows[0];
        for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { uncovered[y * W + x] = 1; src.set([128, 128, 128, 255], (y * W + x) * 4); }
        const { rgba, report } = repeatTexture({ rgba: src, width: W, height: H }, PX, windows, strips, uncovered);
        expect(report.filled).toBeGreaterThan(0);
        expect(lum(px(rgba, x0 + 3, y0 + 8))).toBeLessThan(90);
        // two windows of their own size: fewer than minRepeats, left as photographed
        const two: Array<[number, number, number, number]> = [[9, 10, 21, 26], [39, 10, 51, 26]];
        const left = repeatTexture({ rgba: photo(), width: W, height: H }, PX, two, [], undefined, { ...REPEAT_TEXTURE, minRepeats: 3 });
        expect(left.report.texels).toBe(0);
    });
});
