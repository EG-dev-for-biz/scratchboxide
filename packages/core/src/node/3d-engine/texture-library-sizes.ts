/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Real tile sizes for the texture library sets whose publisher gives none (two thirds of ambientCG's: most of its metal,
 * plaster, marble, granite, concrete and facade sets), estimated by a vision model from each set's colour preview, by
 * the size of what it can recognise in it (bricks, tiles, boards, stones, bolts, grains) and its publisher's description.
 * The estimates are made once by scripts/estimate_texture_library_sizes.ts, scored first against sets whose publisher
 * does give a size, and kept in assets/textures/library/estimated-sizes.json for review; the index loader gives a set
 * without a publisher size its estimate, labelled as such in sizeSource (generated). A publisher's size always wins.
 */

import type { RgbaImage8 } from './staged-location/tile-texture-transfer';

export const ESTIMATED_SIZES_FILE = 'estimated-sizes.json';

export interface EstimatedSizes {
    schema: 'scratchbox.texture-library-sizes/1';
    about: string;
    model: string;
    estimatedAt: string;
    /** The same estimate made for sets whose publisher gives a size: how far off it was. */
    validation?: { sets: number; medianRatio: number; within1_5x: number; within2x: number };
    /** Per set: the width one tile spans, metres, and the model's confidence (0..100). */
    sets: Record<string, { widthM: number; conf: number }>;
}

/** Sets per sheet, on a grid of COLS columns, each preview in a CELL-square. */
export const SIZE_BATCH = 12;
const COLS = 4, CELL = 192, GAP = 10;

/** The previews as one numbered grid (left to right, top to bottom), each fitted in its cell keeping its aspect, on white. */
export function previewSheet(previews: RgbaImage8[]): { width: number; height: number; rgba: Uint8Array } {
    const rows = Math.ceil(previews.length / COLS), W = COLS * (CELL + GAP) + GAP, H = rows * (CELL + GAP) + GAP;
    const out = new Uint8Array(W * H * 4).fill(255);
    previews.forEach((p, k) => {
        const s = Math.max(p.width, p.height) / CELL, w = Math.max(1, Math.round(p.width / s)), h = Math.max(1, Math.round(p.height / s));
        const ox = GAP + (k % COLS) * (CELL + GAP), oy = GAP + Math.floor(k / COLS) * (CELL + GAP);
        for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
            // a box filter over the source pixels this cell pixel covers
            const x0 = Math.floor(x * s), x1 = Math.max(x0 + 1, Math.floor((x + 1) * s)), y0 = Math.floor(y * s), y1 = Math.max(y0 + 1, Math.floor((y + 1) * s));
            const acc = [0, 0, 0];
            let n = 0;
            for (let yy = y0; yy < Math.min(y1, p.height); yy++) for (let xx = x0; xx < Math.min(x1, p.width); xx++) { const q = (yy * p.width + xx) * 4; acc[0] += p.rgba[q]; acc[1] += p.rgba[q + 1]; acc[2] += p.rgba[q + 2]; n++; }
            const d = ((oy + y) * W + ox + x) * 4;
            out[d] = acc[0] / n; out[d + 1] = acc[1] / n; out[d + 2] = acc[2] / n; out[d + 3] = 255;
        }
    });
    return { width: W, height: H, rgba: out };
}

export function sizePrompt(texts: string[]): string {
    return [
        `This image is a grid of ${texts.length} seamless texture maps (numbered 1 to ${texts.length}, left to right, top to bottom), each the colour map of one physically based material set, photographed or scanned flat and face on.`,
        "For each, estimate the real width in metres of the surface the whole image spans, from the size of what you can recognise in it (bricks, tiles, boards, stones, rivets, bolts, weave, aggregate grains, scratches, stains) and the publisher's description:",
        ...texts.map((t, k) => `${k + 1}. ${t.replace(/\s+/g, ' ').slice(0, 160)}`),
        'Give for each "n", "widthM" (metres) and "conf" (0..100). Answer with JSON only: {"sets":[{"n":1,"widthM":0,"conf":0}]}'
    ].join('\n');
}

/** The reply: per set (in order), its width, or none where the reply gave none or an implausible one. Throws on anything malformed. */
export function parseSizes(text: string, count: number): Array<{ widthM: number; conf: number } | undefined> {
    const a = text.indexOf('{'), b = text.lastIndexOf('}');
    if (a < 0 || b <= a) throw new Error('the reply holds no JSON object');
    const j = JSON.parse(text.slice(a, b + 1));
    if (!Array.isArray(j?.sets)) throw new Error('the reply has no "sets" list');
    const out: Array<{ widthM: number; conf: number } | undefined> = new Array(count).fill(undefined);
    for (const s of j.sets) {
        if (typeof s?.n !== 'number' || typeof s.widthM !== 'number') throw new Error('a set without "n" or "widthM"');
        const k = Math.round(s.n) - 1;
        // a millimetre to a kilometre: anything else is not a reading
        if (k < 0 || k >= count || !(s.widthM >= 0.001 && s.widthM <= 1000)) continue;
        out[k] = { widthM: Math.round(s.widthM * 1000) / 1000, conf: typeof s.conf === 'number' && Number.isFinite(s.conf) ? Math.max(0, Math.min(100, s.conf)) : 50 };
    }
    return out;
}

/** How far estimates fall from known widths: the median ratio (larger over smaller) and the shares within 1.5x and 2x. */
export function scoreEstimates(pairs: Array<{ estimatedM: number; knownM: number }>): { sets: number; medianRatio: number; within1_5x: number; within2x: number } {
    const r = pairs.map(p => Math.max(p.estimatedM, p.knownM) / Math.min(p.estimatedM, p.knownM)).sort((a, b) => a - b);
    const share = (t: number) => (r.length ? Math.round((r.filter(v => v <= t).length / r.length) * 1000) / 1000 : 0);
    return { sets: r.length, medianRatio: r.length ? Math.round(r[r.length >> 1] * 100) / 100 : 0, within1_5x: share(1.5), within2x: share(2) };
}
