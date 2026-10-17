/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/** Labelled panel strips of texture planes for the tile transfer tests, saved under test-results/screenshots/texture_tile/. */

import * as fs from 'fs';
import * as path from 'path';
import { encodePng } from '../../src/node/texture-processing';

export const TEXTURE_TILE_SHOT_DIR = path.resolve(__dirname, '../../../..', 'test-results/screenshots/texture_tile');

export interface Panel { width: number; height: number; rgba: Uint8Array }

/** A panel that shows `alpha 0` texels as a grey checker, so uncovered texels are visible. */
export function planePanel(width: number, height: number, rgba: Uint8Array): Panel {
    const out = new Uint8Array(width * height * 4);
    for (let i = 0; i < width * height; i++) {
        const x = i % width, y = (i / width) | 0;
        if (rgba[i * 4 + 3]) out.set([rgba[i * 4], rgba[i * 4 + 1], rgba[i * 4 + 2], 255], i * 4);
        else { const c = ((x >> 2) + (y >> 2)) & 1 ? 70 : 100; out.set([c, c, c, 255], i * 4); }
    }
    return { width, height, rgba: out };
}

/** Grey ramp of a 0..1 field (alpha 0 where `mask` is 0). */
export function scalarPanel(width: number, height: number, value: (i: number) => number, mask?: (i: number) => boolean): Panel {
    const rgba = new Uint8Array(width * height * 4);
    for (let i = 0; i < width * height; i++) {
        if (mask && !mask(i)) continue;
        const v = Math.round(255 * Math.min(1, Math.max(0, value(i))));
        rgba.set([v, v, v, 255], i * 4);
    }
    return planePanel(width, height, rgba);
}

/** Saves panels side by side (nearest upscale by `scale`, 8 px gaps) as a PNG; returns the path. */
export function saveStrip(name: string, panels: Panel[], scale = 6): string {
    const gap = 8;
    const H = Math.max(...panels.map(p => p.height)) * scale;
    const W = panels.reduce((s, p) => s + p.width * scale, 0) + gap * (panels.length + 1);
    const out = Buffer.alloc(W * (H + 2 * gap) * 4, 255);
    let x0 = gap;
    for (const p of panels) {
        for (let y = 0; y < p.height * scale; y++) for (let x = 0; x < p.width * scale; x++) {
            const s = (((y / scale) | 0) * p.width + ((x / scale) | 0)) * 4;
            const d = ((y + gap) * W + x0 + x) * 4;
            out[d] = p.rgba[s]; out[d + 1] = p.rgba[s + 1]; out[d + 2] = p.rgba[s + 2]; out[d + 3] = 255;
        }
        x0 += p.width * scale + gap;
    }
    fs.mkdirSync(TEXTURE_TILE_SHOT_DIR, { recursive: true });
    const file = path.join(TEXTURE_TILE_SHOT_DIR, `${name}.png`);
    fs.writeFileSync(file, encodePng(W, H + 2 * gap, out));
    return file;
}
